package com.example.shop.domain.repo;

import com.example.shop.domain.Customer;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CustomerRepository extends JpaRepository<Customer, Long> {
  Optional<Customer> findByEmail(String email);

  @Query("select c from Customer c where c.name like :prefix%")
  List<Customer> searchByNamePrefix(@Param("prefix") String prefix);

  @Query(value = "select * from customers where email is null", nativeQuery = true)
  List<Customer> withoutEmail();
}
