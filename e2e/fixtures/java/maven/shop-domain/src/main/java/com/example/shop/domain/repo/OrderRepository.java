package com.example.shop.domain.repo;

import com.example.shop.domain.Order;
import com.example.shop.domain.OrderStatus;
import java.util.List;
import org.springframework.data.repository.CrudRepository;

public interface OrderRepository extends CrudRepository<Order, Long> {
  List<Order> findByStatus(OrderStatus status);

  long countByCustomerId(Long customerId);
}
